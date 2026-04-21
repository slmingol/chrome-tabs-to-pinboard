#!/usr/bin/env node
// Chrome Tabs → Pinboard
// Reads a JSON array of {title, url} from stdin.
// Fetches each page, derives a 5-10 word topic summary, posts to Pinboard.
// Uses only Node built-in modules – no npm installs.
//
// Required env:
//   PINBOARD_TOKEN   username:token  (from https://pinboard.in/settings/password)
//
// Optional env:
//   WINDOW_INDEX     for labelling only (default 1)
//   DELAY_MS         ms between Pinboard writes (default 3200)
//   DRY_RUN          set to "1" to skip Pinboard writes
//   LIMIT            only process first N tabs (0 = all)
//   DEDUPE           set to "1" to skip duplicate URLs
//   REFRESH_CACHE    set to "1" to force refresh bookmark cache

"use strict";

const https = require("https");
const http = require("http");
const zlib = require("zlib");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");

// ─── Config ──────────────────────────────────────────────────────────────────

const PINBOARD_TOKEN = (process.env.PINBOARD_TOKEN || "").trim();
const DRY_RUN        = process.env.DRY_RUN === "1";
const DELAY_MS       = parseInt(process.env.DELAY_MS || "3200", 10);
const LIMIT          = parseInt(process.env.LIMIT || "0", 10);
const DEDUPE         = process.env.DEDUPE === "1";
const CLOSE_TABS     = process.env.CLOSE_TABS === "1";
const REFRESH_CACHE  = process.env.REFRESH_CACHE === "1";

const CACHE_FILE     = "/cache/.pinboard_cache.json";
const CACHE_MAX_AGE  = 24 * 60 * 60 * 1000; // 24 hours

if (!DRY_RUN && !PINBOARD_TOKEN.includes(":")) {
  console.error("Set PINBOARD_TOKEN=username:token (from https://pinboard.in/settings/password)");
  process.exit(1);
}

// ─── Stopwords ───────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "a","an","and","are","as","at","be","but","by","for","from","has","have","how",
  "i","if","in","is","it","its","of","on","or","that","the","their","there",
  "these","this","to","was","we","were","what","when","where","which","who","why",
  "will","with","you","your","about","into","than","then","them","they","our",
  "can","could","should","would","also","not","no","yes","all","any","more",
  "most","other","some","such","only","over","under","between","after","before",
  "up","down","out","off","just","new","best","guide","tips","vs","review",
  "read","watch","video","blog","home","page","using","use","used","learn",
  "get","make","one","two","three","s","re","t","ve","ll","d","m",
  "please","wait","moment","available","added","changed","everything","here",
  "now","like","likes","comments","share","follow","post","posts","click",
  "see","view","views","sign","login","register","subscribe","enable","disable",
  "load","loading","error","try","trying","really","thing","things","way","ways",
  "need","want","got","getting","show","shows","check","via","per","each",
  "verification","com","general","web","reference","don","didn","realize","too",
  "late","shape","march","everyone","man","making","isn","x2019","x2192","x1f535",
  "x1f525","photos","videos","april","became","becoming","description","user","username",
  "status","almost","nobody","users","reddit","hit","youtube"
]);

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Decode common HTML entities */
function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g,  "<")
    .replace(/&gt;/g,  ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function cleanText(s) {
  return decodeEntities((s || "").replace(/\s+/g, " ").trim());
}

function tokenize(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .match(/[a-z][a-z0-9-]{1,30}/g)
    ?.filter(t => {
      if (STOPWORDS.has(t)) return false;
      if (/^\d+$/.test(t)) return false;
      // Filter out random ID-like strings (alphanumeric garbage like Reddit/GitHub IDs)
      const hasDigits = /\d/.test(t);
      const hasLetters = /[a-z]/.test(t);
      if (hasDigits && hasLetters) {
        // Keep if starts with letters and has reasonable letter/digit ratio (like qwen36, gpt4)
        if (/^[a-z]{2,}/.test(t)) {
          const letterCount = (t.match(/[a-z]/g) || []).length;
          const digitCount = (t.match(/\d/g) || []).length;
          // Keep if at least 40% letters (qwen36 = 4/6 = 66%, good)
          if (letterCount / t.length >= 0.4) return true;
        }
        // Otherwise filter short random-looking mixed alphanumeric (5-8 chars)
        if (t.length >= 5 && t.length <= 8) return false;
        // Longer ones with multiple digits are also likely IDs
        const digitCount = (t.match(/\d/g) || []).length;
        if (digitCount >= 2 && t.length >= 5) return false;
      }
      return true;
    }) ?? [];
}

/**
 * Build a 5-10 word topic summary from an array of signal strings.
 * Words are ranked by frequency across all signals.
 */
function buildSummary(signals, minWords = 5, maxWords = 10) {
  const text  = signals.join(" ");
  const toks  = tokenize(text);
  if (!toks.length) return "general web reference";

  const freq = new Map();
  for (const t of toks) freq.set(t, (freq.get(t) || 0) + 1);

  const ranked = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w);

  const picked = [];
  for (const w of ranked) {
    if (picked.length >= maxWords) break;
    if (!picked.includes(w)) picked.push(w);
  }

  // Pad to minWords from original token order if needed
  for (const w of toks) {
    if (picked.length >= minWords) break;
    if (!picked.includes(w)) picked.push(w);
  }

  return picked.slice(0, maxWords).join(" ") || "general web reference";
}

function extractUrlKeywords(url) {
  try {
    const u = new URL(url);
    // Extract meaningful parts from hostname and path
    const parts = [
      ...u.hostname.split(".").filter(p => p.length > 2 && !["www", "com", "org", "net", "io"].includes(p)),
      ...u.pathname.split(/[\/\-_]/).filter(p => p.length > 2)
    ];
    return parts.join(" ");
  } catch {
    return "";
  }
}

function buildTags(summary, url, title) {
  // Combine all sources
  const allText = `${title} ${summary} ${extractUrlKeywords(url)}`;
  const toks = tokenize(allText);
  
  if (!toks.length) return "";
  
  // Count frequency and pick top unique words
  const freq = new Map();
  for (const t of toks) freq.set(t, (freq.get(t) || 0) + 1);
  
  const ranked = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w)
    .filter(w => w.length >= 3);
  
  // Take top 5-7 most meaningful tags
  const tags = [];
  for (const w of ranked) {
    if (tags.length >= 7) break;
    if (!tags.includes(w)) tags.push(w);
  }
  
  return tags.slice(0, 5).join(" ");
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function httpGet(rawUrl, redirects = 5, timeoutMs = 10000, maxSize = 600000) {
  return new Promise((resolve, reject) => {
    if (redirects < 0) return reject(new Error("Too many redirects"));

    let u;
    try { u = new URL(rawUrl); }
    catch (e) { return reject(e); }

    const lib = u.protocol === "https:" ? https : http;
    
    // For X.com/Twitter, use more convincing browser headers
    const isTwitter = /\b(x\.com|twitter\.com)\b/i.test(rawUrl);
    
    const headers = isTwitter ? {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "max-age=0",
      "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"macOS"',
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
    } : {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    };
    
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "GET",
      timeout: timeoutMs,
      headers,
    };

    const req = lib.request(opts, res => {
      const { statusCode, headers } = res;
      
      if ([301,302,303,307,308].includes(statusCode) && headers.location) {
        res.resume();
        const next = new URL(headers.location, rawUrl).href;
        return resolve(httpGet(next, redirects - 1, timeoutMs, maxSize));
      }

      const ct = headers["content-type"] || "";
      // Accept HTML or JSON responses (Pinboard uses text/json)
      if (!ct.includes("text/html") && !ct.includes("json")) {
        res.resume();
        return resolve(null);
      }

      // Handle compressed responses
      const encoding = headers["content-encoding"];
      let stream = res;
      if (encoding === "gzip") {
        stream = res.pipe(zlib.createGunzip());
      } else if (encoding === "deflate") {
        stream = res.pipe(zlib.createInflate());
      } else if (encoding === "br") {
        stream = res.pipe(zlib.createBrotliDecompress());
      }

      const chunks = [];
      let size = 0;
      let settled = false;
      const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

      stream.on("data", chunk => {
        size += chunk.length;
        chunks.push(chunk);
        // Only truncate if maxSize is set (not Infinity)
        if (maxSize && size >= maxSize) {
          // Resolve with what we have then kill the stream
          settle(resolve, Buffer.concat(chunks).toString("utf8"));
          stream.destroy();
          res.destroy();
        }
      });
      stream.on("end",   () => settle(resolve, Buffer.concat(chunks).toString("utf8")));
      stream.on("error", err => settle(reject, err));
      res.on("error", err => settle(reject, err));
    });

    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.on("error", reject);
    req.end();
  });
}

// ─── Minimal HTML scraping (no DOM library) ──────────────────────────────────

function extractMeta(html, name) {
  const patterns = [
    new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']{0,400})`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']{0,400})["'][^>]+name=["']${name}["']`, "i"),
    new RegExp(`<meta[^>]+property=["']${name}["'][^>]+content=["']([^"']{0,400})`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']{0,400})["'][^>]+property=["']${name}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return cleanText(m[1]);
  }
  return null;
}

function extractTag(html, tag) {
  const m = html.match(new RegExp(`<${tag}[^>]*>([^<]{0,500})`, "i"));
  return m ? cleanText(m[1].replace(/<[^>]+>/g, " ")) : null;
}

function extractKeywordsFromHtml(html) {
  // Extract all text from meta keywords if present
  const keywords = extractMeta(html, "keywords");
  if (keywords) return keywords;
  
  // Look for JSON-LD structured data
  const jsonLdMatch = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]{0,5000}?)<\/script>/i);
  if (jsonLdMatch) {
    try {
      const data = JSON.parse(jsonLdMatch[1]);
      const parts = [];
      if (data.headline) parts.push(data.headline);
      if (data.description) parts.push(data.description);
      if (data.keywords) parts.push(Array.isArray(data.keywords) ? data.keywords.join(" ") : data.keywords);
      if (parts.length) return parts.join(" ");
    } catch {}
  }
  
  // Extract from article tags
  const articleMatch = html.match(/<article[^>]*>([\s\S]{0,2000}?)<\/article>/i);
  if (articleMatch) {
    const text = articleMatch[1].replace(/<[^>]+>/g, " ");
    return cleanText(text);
  }
  
  return "";
}

function fetchPageSignals(url, fallbackTitle) {
  // Check domain-specific handling
  const isTwitter = /\b(x\.com|twitter\.com)\b/i.test(url);
  const isMedium = /\bmedium\.com\b/i.test(url);
  const isYouTube = /\byoutube\.com\b|\byoutu\.be\b/i.test(url);
  const isReddit = /\breddit\.com\b/i.test(url);
  
  if (isYouTube) {
    // Extract video ID from URL
    const videoIdMatch = url.match(/[?&]v=([^&]+)/);
    const videoId = videoIdMatch ? videoIdMatch[1] : null;
    
    if (videoId) {
      // Try YouTube oEmbed API for clean metadata
      const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
      return httpGet(oembedUrl)
        .then(raw => {
          if (!raw) throw new Error("Empty oEmbed response");
          const data = JSON.parse(raw);
          const signals = [];
          
          // Video title from oEmbed
          if (data.title) {
            signals.push(cleanText(data.title));
            signals.push(cleanText(data.title));
            signals.push(cleanText(data.title)); // triple weight
          }
          
          // Author/channel name
          if (data.author_name) {
            signals.push(cleanText(data.author_name));
          }
          
          return signals.filter(s => s && s.length > 3);
        })
        .catch(err => {
          // Fallback to tab title if we have it
          if (fallbackTitle && fallbackTitle.length > 3) {
            const cleanTitle = cleanText(fallbackTitle).replace(/\s*-?\s*youtube\s*$/i, '').trim();
            return [cleanTitle, cleanTitle, cleanTitle];
          }
          return ["video"];
        });
    }
    
    // No video ID found, return generic
    return Promise.resolve(["video"]);
  }
  
  if (isReddit) {
    return httpGet(url)
      .then(html => {
        const signals = [];
        
        // Extract subreddit and post title from URL path
        // Format: /r/subreddit/comments/id/post_title/
        const pathMatch = url.match(/\/r\/([^\/]+)\/comments\/[^\/]+\/([^\/]+)/);
        if (pathMatch) {
          const subreddit = pathMatch[1];
          const postSlug = pathMatch[2].replace(/_/g, ' ');
          signals.push(cleanText(postSlug));
          signals.push(cleanText(postSlug)); // double weight
          signals.push(cleanText(subreddit));
        }
        
        // Try og:title (usually has post title)
        const ogTitle = extractMeta(html, "og:title");
        if (ogTitle && ogTitle.length > 5) {
          signals.push(cleanText(ogTitle));
        }
        
        // Try og:description (post preview text)
        const ogDesc = extractMeta(html, "og:description");
        if (ogDesc && ogDesc.length > 30) {
          const descShort = ogDesc.slice(0, 200);
          signals.push(cleanText(descShort));
        }
        
        // Fallback to Chrome tab title
        if (fallbackTitle && fallbackTitle.length > 5) {
          const cleanTitle = cleanText(fallbackTitle).replace(/\s*:?\s*r\/[^\s]+\s*$/i, '').trim();
          if (cleanTitle.length > 5) signals.push(cleanTitle);
        }
        
        return signals.filter(s => s && s.length > 3);
      })
      .catch(() => {
        // Fallback: extract from URL only
        const pathMatch = url.match(/\/r\/([^\/]+)\/comments\/[^\/]+\/([^\/]+)/);
        if (pathMatch) {
          const postSlug = pathMatch[2].replace(/_/g, ' ');
          const subreddit = pathMatch[1];
          return [cleanText(postSlug), cleanText(postSlug), cleanText(subreddit)];
        }
        return ["reddit"];
      });
  }
  
  if (isTwitter) {
    // Fallback to HTTP fetching
    return httpGet(url)
      .then(html => {
        const signals = [];
        
        // Extract username from URL
        const usernameMatch = url.match(/\/(x|twitter)\.com\/([^\/]+)/i);
        if (usernameMatch && usernameMatch[2] && !['home', 'search', 'i', 'explore'].includes(usernameMatch[2].toLowerCase())) {
          const username = usernameMatch[2].replace(/@/g, '');
          if (username.length > 2 && username.length < 20) {
            signals.push(username);
          }
        }
        
        // Chrome tab title - but heavily validate it's not garbage
        if (fallbackTitle && fallbackTitle.length > 10) {
          const cleanTitle = cleanText(fallbackTitle)
            .replace(/\s*on x:?\s*$/i, '')
            .replace(/\s*\|\s*x\s*$/i, '')
            .replace(/\s*\/\s*x\s*$/i, '')
            .replace(/^x\s*$/i, '')
            .trim();
          
          // Reject if it's garbage patterns
          const isGarbage = 
            cleanTitle.match(/^[a-z]{1,2}(\s+[a-z]{1,2})+$/i) ||  // "f f f" or "a b c"
            cleanTitle.match(/^[a-z0-9]{6,}$/i) ||                 // "ffffff" or "123456"
            cleanTitle.match(/^[\W\s]+$/) ||                       // Only symbols/spaces
            cleanTitle.length < 15;                                 // Too short to be real tweet
          
          // Only use if it looks like real content
          if (!isGarbage && cleanTitle.length > 15) {
            signals.push(cleanTitle);
            signals.push(cleanTitle);
            signals.push(cleanTitle);
          }
        }
        
        if (!html) {
          // If no HTML and tab title was useless, add generic tags
          if (signals.length < 2) {
            signals.push("twitter", "tweet", "social");
          }
          return signals.filter(Boolean);
        }
        
        // Debug: check what meta tags we find
        
        // Try to extract embedded JSON data (X.com embeds tweet data in the HTML)
        // Look for full_text field directly in the HTML as it's most reliable
        // Extract the status ID from the URL to find the right tweet
        const statusMatch = url.match(/status\/(\d+)/);
        const statusId = statusMatch ? statusMatch[1] : null;
        
        let tweetText = null;
        
        // If we have a status ID, try to find the full_text near it in the HTML
        if (statusId) {
          // Try both directions: id_str before full_text, or full_text before id_str
          const patterns = [
            // Pattern 1: id_str comes before full_text (within 5000 chars)
            new RegExp(`"id_str":"${statusId}"[^}]{0,5000}?"full_text"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 's'),
            // Pattern 2: full_text comes before id_str (within 5000 chars)
            new RegExp(`"full_text"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"[^}]{0,5000}?"id_str":"${statusId}"`, 's'),
          ];
          
          for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match && match[1]) {
              tweetText = match[1];
              break;
            }
          }
        }
        
        // Fallback: just grab the first full_text if we couldn't match by ID
        if (!tweetText) {
          const fullTextMatch = html.match(/"full_text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (fullTextMatch && fullTextMatch[1]) {
            tweetText = fullTextMatch[1];
          }
        }
        
        if (tweetText) {
          // First decode JSON escape sequences
          try {
            tweetText = JSON.parse('"' + tweetText + '"');
          } catch (e) {
            // Fallback to manual replacement if JSON parsing fails
            tweetText = tweetText
              .replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
              .replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
              .replace(/\\"/g, '"')
              .replace(/\\n/g, ' ')
              .replace(/\\t/g, ' ')
              .replace(/\\r/g, ' ')
              .replace(/\\\\/g, '\\');
          }
          
          // Then decode HTML entities (X.com uses these in JSON!)
          tweetText = tweetText
            .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
            .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&');
          
          if (tweetText.length > 30) {
            const cleanTweet = cleanText(tweetText);
            signals.push(cleanTweet);
            signals.push(cleanTweet);
            signals.push(cleanTweet); // Triple weight
            
            // Extract hashtags
            const hashtags = tweetText.match(/#[a-zA-Z0-9_]{2,30}/g);
            if (hashtags) {
              hashtags.slice(0, 5).forEach(h => signals.push(h.substring(1).toLowerCase()));
            }
            
            signals.push("twitter", "social");
            return signals.filter(Boolean);
          }
        }
        
        // Fallback: Try to parse JSON blobs if full_text not found directly
        const hasPlaceholders = /f{4,}|x{4,}|placeholder|loading/gi.test(html);
        if (hasPlaceholders || signals.length < 2) {
          // X.com embeds initial state in script tags - try multiple patterns
          const jsonMatches = html.match(/<script[^>]*>\s*window\.__INITIAL_STATE__\s*=\s*(\{.+?\})\s*<\/script>/s) ||
                             html.match(/<script[^>]*>\s*(\{"props":.+?)\s*<\/script>/s) ||
                             html.match(/<script[^>]*type=["']application\/json["'][^>]*>(\{.+?\})<\/script>/gs) ||
                             html.match(/<script[^>]*>\s*(\{.{100,}full_text.{100,}\})</s);
          
          if (jsonMatches && jsonMatches[1]) {
            try {
              const jsonData = JSON.parse(jsonMatches[1]);
              
              // Try to extract tweet text from various possible locations in the JSON
              const extractFromJson = (obj, maxDepth = 5) => {
                if (maxDepth <= 0 || !obj || typeof obj !== 'object') return [];
                
                const texts = [];
                
                // Look for common tweet text fields
                if (obj.text && typeof obj.text === 'string' && obj.text.length > 20) {
                  texts.push(cleanText(obj.text));
                }
                if (obj.full_text && typeof obj.full_text === 'string' && obj.full_text.length > 20) {
                  texts.push(cleanText(obj.full_text));
                }
                if (obj.tweet_text && typeof obj.tweet_text === 'string' && obj.tweet_text.length > 20) {
                  texts.push(cleanText(obj.tweet_text));
                }
                
                // Recursively search nested objects/arrays
                for (const key in obj) {
                  if (key === 'text' || key === 'full_text' || key === 'content' || key === 'tweet') {
                    const val = obj[key];
                    if (typeof val === 'string' && val.length > 20 && !val.match(/f{4,}/i)) {
                      texts.push(cleanText(val));
                    } else if (typeof val === 'object') {
                      texts.push(...extractFromJson(val, maxDepth - 1));
                    }
                  }
                }
                
                return texts;
              };
              
              const extractedTexts = extractFromJson(jsonData);
              if (extractedTexts.length > 0) {
                // Use first valid tweet text found
                for (const text of extractedTexts.slice(0, 3)) {
                  if (text.length > 20) {
                    signals.push(text);
                  }
                }
              }
            } catch (e) {
              // JSON parsing failed, continue with generic tags
            }
          }
          
          // If we still don't have much content, add generic tags
          if (signals.length < 2) {
            signals.push("twitter", "social", "tweet");
          }
          return signals.filter(Boolean);
        }
        
        // Extract hashtags from any available content
        const hashtagMatches = html.match(/#[a-zA-Z0-9_]{2,30}/g);
        if (hashtagMatches) {
          const hashtags = [...new Set(hashtagMatches)]
            .slice(0, 5)
            .map(h => h.substring(1).toLowerCase());
          signals.push(...hashtags);
        }
        
        // Twitter meta tags
        for (const name of ["twitter:description", "og:description", "description", "twitter:title", "og:title"]) {
          const v = extractMeta(html, name);
          if (v && v.length > 20 && !v.match(/javascript|moment|^x$/i)) {
            // Filter out generic X/Twitter descriptions AND placeholder garbage
            const lowerV = v.toLowerCase();
            const hasPlaceholder = 
              lowerV.includes('join the conversation') || 
              lowerV.includes('log in to twitter') ||
              lowerV.includes('sign up for x') ||
              lowerV.includes('something went wrong') ||
              /f{4,}/.test(lowerV) ||           // "ffffff" patterns
              /x{4,}/.test(lowerV) ||           // "xxxxxx" patterns
              /^[a-z]{1,3}(\s+[a-z]{1,3})+$/i.test(v);  // "f f f" or "a b c" patterns
            
            if (!hasPlaceholder) {
              const cleaned = cleanText(v);
              // Double-check cleaned version isn't garbage
              if (cleaned.length > 20 && !/^[a-z0-9]{6,}$/i.test(cleaned)) {
                signals.push(cleaned);
              }
            }
          }
        }
        
        // Twitter image alt text (sometimes contains tweet text)
        const imageAlt = extractMeta(html, "twitter:image:alt");
        if (imageAlt && imageAlt.length > 20) {
          signals.push(cleanText(imageAlt));
        }
        
        // Author/creator
        const creator = extractMeta(html, "twitter:creator") || extractMeta(html, "twitter:site");
        if (creator && creator.length > 2) {
          const cleanCreator = creator.replace(/@/g, '').trim();
          if (cleanCreator.length > 2 && cleanCreator.length < 20 && cleanCreator !== 'x') {
            signals.push(cleanCreator);
          }
        }
        
        // Look for tweet text in various places
        // Try noscript content (often has server-rendered text)
        const noscriptMatch = html.match(/<noscript[^>]*>([\s\S]{10,2000}?)<\/noscript>/i);
        if (noscriptMatch) {
          const noscriptText = noscriptMatch[1].replace(/<[^>]+>/g, ' ');
          const cleanNoscript = cleanText(noscriptText);
          // Reject garbage
          const isGarbage = cleanNoscript.match(/f{4,}|x{4,}|^[a-z]{1,3}(\s+[a-z]{1,3})+$/i);
          if (!isGarbage && cleanNoscript.length > 30) {
            signals.push(cleanNoscript);
          }
        }
        
        // Look for any text in data attributes or alt attributes
        const dataTextMatch = html.match(/(?:data-text|alt|aria-label)=["']([^"']{20,500})["']/gi);
        if (dataTextMatch) {
          for (const match of dataTextMatch.slice(0, 3)) {
            const textMatch = match.match(/=["']([^"']+)["']/);
            if (textMatch) {
              const text = cleanText(textMatch[1]);
              // Reject garbage and generic strings
              const isGarbage = 
                text.toLowerCase().includes('profile picture') ||
                text.match(/f{4,}|x{4,}/i) ||
                text.match(/^[a-z]{1,3}(\s+[a-z]{1,3})+$/i);
              
              if (!isGarbage && text.length > 20) {
                signals.push(text);
              }
            }
          }
        }
        
        // Try to extract from title tag (lower priority)
        const title = extractTag(html, "title");
        if (title && title.length > 20) {
          const cleanedTitle = cleanText(title);
          // Reject garbage patterns
          const isGarbage = 
            cleanedTitle.match(/^x$|log in|sign up|javascript|moment/i) ||
            cleanedTitle.match(/f{4,}|x{4,}/i) ||
            cleanedTitle.match(/^[a-z]{1,3}(\s+[a-z]{1,3})+$/i) ||
            cleanedTitle.match(/^[a-z0-9]{6,}$/i);
          
          if (!isGarbage && cleanedTitle.length > 20) {
            signals.push(cleanedTitle);
          }
        }
        
        // If we still have very little, add generic twitter context
        if (signals.length < 3) {
          signals.push("twitter", "social", "tweet");
        }
        
        return signals.filter(Boolean);
      })
      .catch((err) => {
        if (DRY_RUN) console.error(`DEBUG Twitter fetch error: ${err.message}`);
        
        // Fallback: at least use username
        const signals = [];
        
        // Username from URL
        const usernameMatch = url.match(/\/(x|twitter)\.com\/([^\/]+)/i);
        if (usernameMatch && usernameMatch[2]) {
          const username = usernameMatch[2].replace(/@/g, '');
          if (username.length > 2 && username.length < 20) {
            signals.push(username);
          }
        }
        
        // Add generic tags 
        signals.push("twitter", "tweet", "social");
        
        return signals;
      });
  }
  
  if (isMedium) {
    return httpGet(url)
      .then(html => {
        if (!html) return [cleanText(fallbackTitle), cleanText(fallbackTitle), cleanText(fallbackTitle)];
        
        const signals = [];
        
        signals.push(cleanText(fallbackTitle));
        signals.push(cleanText(fallbackTitle));
        
        // Extract all possible metadata
        for (const name of ["description","og:description","twitter:description","og:title","twitter:title"]) {
          const v = extractMeta(html, name);
          if (v && v.length > 10 && !v.match(/javascript|moment/i)) signals.push(v);
        }
        
        // Try keyword extraction
        const kw = extractKeywordsFromHtml(html);
        if (kw && kw.length > 10) signals.push(kw);
        
        // Fallback to title last (lower priority for these sites since tab title is usually better)
        const title = extractTag(html, "title");
        if (title && title.length > 10 && !title.match(/javascript|moment/i)) signals.push(title);
        
        return signals.filter(Boolean);
      })
      .catch(() => [cleanText(fallbackTitle), cleanText(fallbackTitle), cleanText(fallbackTitle)]);
  }
  
  // For other sites, use standard extraction with tab title weighted heavily
  // Weight the Chrome tab title heavily (it's always accurate)
  const signals = [
    cleanText(fallbackTitle),
    cleanText(fallbackTitle), // duplicate to increase frequency weight
  ];
  return httpGet(url)
    .then(html => {
      if (!html) return signals;

      const title = extractTag(html, "title");
      if (title) signals.push(title);

      for (const name of ["description","og:description","twitter:description"]) {
        const v = extractMeta(html, name);
        if (v) signals.push(v);
      }

      const h1 = extractTag(html, "h1");
      if (h1) signals.push(h1);

      const p = extractTag(html, "p");
      if (p) signals.push(p);

      return signals.filter(Boolean);
    })
    .catch(() => signals);
}

// ─── Pinboard API ─────────────────────────────────────────────────────────────

function pinboardGetAll() {
  // Check cache first if not forcing refresh
  if (!REFRESH_CACHE) {
    try {
      const stats = fs.statSync(CACHE_FILE);
      const age = Date.now() - stats.mtimeMs;
      if (age < CACHE_MAX_AGE) {
        const cached = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
        console.error(`Using cached bookmarks (${(age / 3600000).toFixed(1)}h old, ${cached.length} bookmarks).`);
        return Promise.resolve(new Set(cached));
      } else {
        console.error("Cache expired, fetching fresh bookmarks...");
      }
    } catch (err) {
      // Cache doesn't exist or is invalid, will fetch from API
      console.error("No valid cache found, fetching bookmarks...");
    }
  } else {
    console.error("Refreshing bookmark cache...");
  }
  
  const params = new URLSearchParams({
    auth_token: PINBOARD_TOKEN,
    format:      "json",
  });
  const apiUrl = `https://api.pinboard.in/v1/posts/all?${params}`;
  return httpGet(apiUrl, 5, 60000, Infinity).then(raw => {
    if (!raw) return [];
    const data = JSON.parse(raw);
    // Returns array of bookmark objects with {href, description, extended, tags, ...}
    const urls = data.map(post => post.href);
    console.error(`Fetched ${urls.length} bookmark(s) from Pinboard.`);
    
    // Save to cache
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(urls, null, 2), "utf8");
      console.error(`Saved to cache: ${CACHE_FILE}`);
    } catch (err) {
      console.error(`Warning: Failed to save cache: ${err.message}`);
    }
    
    return new Set(urls);
  }).catch(err => {
    console.error(`Warning: Failed to fetch existing bookmarks: ${err.message}`);
    return new Set();
  });
}

function pinboardAdd(url, title, summary, tags) {
  const params = new URLSearchParams({
    auth_token: PINBOARD_TOKEN,
    format:      "json",
    url,
    description: (title || url).slice(0, 255),
    extended:    summary,
    tags,
    shared:      "yes",
    toread:      "yes",
    replace:     "yes",
  });
  const apiUrl = `https://api.pinboard.in/v1/posts/add?${params}`;
  return httpGet(apiUrl).then(raw => {
    if (!raw) throw new Error("Empty response from Pinboard API");
    const data = JSON.parse(raw);
    if (data?.result_code !== "done") {
      throw new Error(`Pinboard API error: ${JSON.stringify(data)}`);
    }
    return data;
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Read JSON array of {title, url} from stdin
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks.map(c => Buffer.from(c))).toString("utf8").trim();

  let tabs;
  try {
    tabs = JSON.parse(raw);
  } catch (e) {
    console.error("Failed to parse stdin as JSON:", e.message);
    process.exit(1);
  }

  if (!Array.isArray(tabs) || !tabs.length) {
    console.error("No tabs found in input.");
    process.exit(1);
  }

  // Filter to http/https only
  const httpTabs = tabs.filter(t => /^https?:\/\//i.test(t.url || ""));
  if (tabs.length !== httpTabs.length) {
    console.error(`Filtered ${tabs.length - httpTabs.length} non-HTTP/S tabs.`);
  }
  tabs = httpTabs;

  // Skip internal / unwanted domains
  const beforeSkip = tabs.length;
  tabs = tabs.filter(t => {
    try {
      const urlObj = new URL(t.url);
      const host = urlObj.hostname.toLowerCase();
      const path = urlObj.pathname.toLowerCase();
      
      // Custom Google filtering: skip google.com/www.google.com but allow subdomains and PDFs
      if (/^(www\.)?google\.com$/.test(host)) {
        // Allow if URL contains PDF
        if (path.includes('.pdf') || path.includes('/pdf')) {
          return true;
        }
        console.error(`Skipping ${host}: ${t.url.slice(0, 60)}`);
        return false;
      }
      
      // Skip other unwanted domains
      const SKIP_PATTERNS = [/lamolabs/, /flomarching/, /\bpinboard\.in\b/];
      const skip = SKIP_PATTERNS.some(re => re.test(host));
      if (skip) console.error(`Skipping ${host}: ${t.url.slice(0, 60)}`);
      return !skip;
    } catch (e) {
      console.error(`Invalid URL (skipped): ${t.url}`);
      return false;
    }
  });
  console.error(`Skipped ${beforeSkip - tabs.length} filtered domain(s).`);

  // Dedupe
  if (DEDUPE) {
    const seen = new Set();
    tabs = tabs.filter(t => { const k = t.url; if (seen.has(k)) return false; seen.add(k); return true; });
  }

  // Limit
  if (LIMIT > 0) tabs = tabs.slice(0, LIMIT);

  console.log(`Processing ${tabs.length} tab(s) ...`);
  if (DRY_RUN) console.log("DRY RUN – nothing will be written to Pinboard.\n");

  // Fetch all existing Pinboard bookmarks once (or use cache)
  const existingUrls = DRY_RUN ? new Set() : await pinboardGetAll();
  if (!DRY_RUN && existingUrls.size > 0) {
    console.log(`Checking against ${existingUrls.size} existing bookmark(s).\n`);
  }

  let ok = 0, failed = 0, skipped = 0;

  for (let i = 0; i < tabs.length; i++) {
    const { title, url } = tabs[i];
    const label = `[${i + 1}/${tabs.length}]`;

    const signals = await fetchPageSignals(url, title);
    const summary = buildSummary(signals);
    const tags    = buildTags(summary, url, title);

    if (DRY_RUN) {
      console.log(`${label} ${title?.slice(0, 70)}`);
      console.log(`  URL:     ${url}`);
      console.log(`  SUMMARY: ${summary}`);
      console.log(`  TAGS:    ${tags}`);
      console.log();
      continue;
    }

    // Check local Set instead of API
    if (existingUrls.has(url)) {
      skipped++;
      console.log(`${label} ⊘  ${title?.slice(0, 60)} (already in Pinboard)`);
      console.log(`       ${url}`);
      // Mark for closing if flag set
      if (CLOSE_TABS) console.log(`SUCCESS_URL:${url}`);
      continue;
    }

    try {
      await pinboardAdd(url, title, summary, tags);
      ok++;
      console.log(`${label} ✓  ${title?.slice(0, 70)}`);
      console.log(`       ${url}`);
      // Output success marker for tab closing (filtered out in run.sh before display)
      if (CLOSE_TABS) console.log(`SUCCESS_URL:${url}`);
    } catch (err) {
      failed++;
      console.error(`${label} ✗  ${url}`);
      console.error(`       ${err.message}`);
    }

    if (i < tabs.length - 1) await sleep(DELAY_MS);
  }

  if (!DRY_RUN) {
    console.log(`\nDone. Added: ${ok}  Skipped: ${skipped}  Failed: ${failed}`);
  }
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});

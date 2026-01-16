(() => {
  "use strict";

  const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 ساعة
  const CACHE_KEY = "ai_news_cache_v4";
  const PREFS_KEY = "ai_news_prefs_v2";

  // حدود تنويع الأخبار
  const MAX_TOTAL_ARTICLES = 30;
  const MAX_PER_SOURCE = 8;
  const CONCURRENCY = 4;

  // مصادر عربية + أجنبية (الأجنبية تُترجم تلقائياً للعربية)
  const SOURCES = [
    // عربية
    {
      id: "aitnews",
      name: "البوابة التقنية",
      homepage: "https://aitnews.com/",
      rss: "https://aitnews.com/tag/%D8%A7%D9%84%D8%B0%D9%83%D8%A7%D8%A1-%D8%A7%D9%84%D8%A7%D8%B5%D8%B7%D9%86%D8%A7%D8%B9%D9%8A/feed/"
    },
    {
      id: "techwd",
      name: "عالم التقنية",
      homepage: "https://www.tech-wd.com/wd/",
      rss: "https://www.tech-wd.com/wd/tag/%D8%A7%D9%84%D8%B0%D9%83%D8%A7%D8%A1-%D8%A7%D9%84%D8%A7%D8%B5%D8%B7%D9%86%D8%A7%D8%B9%D9%8A/feed/"
    },
    {
      id: "techecho",
      name: "صدى التقنية",
      homepage: "https://tech-echo.com/ai/",
      rss: "https://tech-echo.com/ai/feed/"
    },

    // أجنبية
    {
      id: "verge_ai",
      name: "The Verge (AI)",
      homepage: "https://www.theverge.com/ai-artificial-intelligence",
      rss: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml"
    },
    {
      id: "tc_ai",
      name: "TechCrunch (AI)",
      homepage: "https://techcrunch.com/tag/artificial-intelligence/",
      rss: "https://techcrunch.com/tag/artificial-intelligence/feed/"
    },
    {
      id: "mit_ai",
      name: "MIT Technology Review (AI)",
      homepage: "https://www.technologyreview.com/topic/artificial-intelligence/",
      rss: "https://www.technologyreview.com/topic/artificial-intelligence/feed/"
    }
  ];

  // جلب RSS/صفحات الأخبار
  const PROXY_RAW = (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
  const RSS2JSON = (rssUrl) => `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}`;

  // ترجمة (يمكن استبدالها لاحقاً بأي مزود)
  const TRANSLATE_ENDPOINT = "https://libretranslate.de/translate";

  // عناصر
  const el = {
    status: document.getElementById("status"),
    newsGrid: document.getElementById("newsGrid"),
    highlightsGrid: document.getElementById("highlightsGrid"),
    lastUpdated: document.getElementById("lastUpdated"),
    nextUpdate: document.getElementById("nextUpdate"),
    refreshBtn: document.getElementById("refreshBtn"),
    themeToggle: document.getElementById("themeToggle"),
    sortSelect: document.getElementById("sortSelect"),
    chips: document.getElementById("chips"),
    searchForm: document.getElementById("searchForm"),
    searchInput: document.getElementById("searchInput"),
    subscribeForm: document.getElementById("subscribeForm"),
    emailInput: document.getElementById("emailInput"),
    toast: document.getElementById("toast"),
    totalCount: document.getElementById("totalCount"),
    sourceCount: document.getElementById("sourceCount"),
    cachedBadge: document.getElementById("cachedBadge"),
    sourceList: document.getElementById("sourceList")
  };

  const state = {
    loading: false,
    articles: [],
    filtered: [],
    category: "all",
    query: "",
    sort: "new",
    lastFetchAt: 0
  };

  // UI
  function setStatus(message) { if (el.status) el.status.textContent = message; }
  function showToast(message) {
    if (!el.toast) return;
    el.toast.textContent = message;
    el.toast.classList.add("is-show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.toast.classList.remove("is-show"), 3000);
  }

  // Utils
  function escapeHtml(str = "") {
    return String(str)
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  function stripHtml(html = "") {
    return String(html)
      .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "")
      .replace(/<\/?[^>]+(>|$)/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function clampText(text = "", max = 170) {
    const t = String(text).replace(/\s+/g, " ").trim();
    return t.length <= max ? t : t.slice(0, max - 1) + "…";
  }

  function toArabicDateTime(iso) {
    try {
      const d = new Date(iso);
      return new Intl.DateTimeFormat("ar", {
        year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit"
      }).format(d);
    } catch { return "—"; }
  }

  function toISOStringSafe(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }

  function isArabicText(text = "") { return /[\u0600-\u06FF]{3,}/.test(text); }

  function resolveUrl(url, base) {
    if (!url) return "";
    const cleaned = String(url).trim().replaceAll("&amp;", "&");
    try { return new URL(cleaned, base || undefined).href; } catch { return ""; }
  }

  function firstGoodUrl(urls, base) {
    for (const u of urls) {
      const r = resolveUrl(u, base);
      if (r && r.startsWith("https://")) return r;
    }
    return "";
  }

  function guessCategory(text = "") {
    const t = text.toLowerCase();
    const has = (...w) => w.some(x => t.includes(x));

    if (has("ورقة", "بحث", "دراسة", "arxiv", "paper", "research", "benchmark", "dataset")) return "research";
    if (has("قانون", "تنظيم", "تشريع", "policy", "regulation", "law", "eu ai act")) return "policy";
    if (has("أمن", "ثغرة", "اختراق", "security", "safety", "vulnerability", "attack")) return "security";
    if (has("شركة", "تمويل", "استحواذ", "startup", "funding", "acquire", "ipo")) return "companies";
    if (has("إطلاق", "ميزة", "تحديث", "منتج", "نموذج", "tools", "release", "launch", "update", "model")) return "products";
    return "all";
  }

  function uniqueByLink(items) {
    const seen = new Set();
    const out = [];
    for (const it of items) {
      const key = it.link || it.id;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(it);
    }
    return out;
  }

  function sortItems(items, sortMode) {
    const copy = [...items];
    copy.sort((a, b) => {
      const ta = new Date(a.pubDate).getTime();
      const tb = new Date(b.pubDate).getTime();
      return sortMode === "old" ? ta - tb : tb - ta;
    });
    return copy;
  }

  function formatCountdown(ms) {
    const m = Math.max(0, ms);
    const totalSec = Math.floor(m / 1000);
    const h = Math.floor(totalSec / 3600);
    const min = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(h)}:${pad(min)}:${pad(s)}`;
  }

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.articles)) return null;
      return data;
    } catch { return null; }
  }

  function writeCache(payload) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(payload)); } catch {} }

  function readPrefs() {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"); } catch { return {}; }
  }

  function writePrefs(prefs) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {} }

  function isStale(lastFetchAt) {
    return !lastFetchAt || (Date.now() - lastFetchAt) >= UPDATE_INTERVAL_MS;
  }

  async function fetchWithTimeout(url, { timeoutMs = 18000 } = {}) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetch(url, { signal: controller.signal }); }
    finally { clearTimeout(t); }
  }

  async function fetchTextSmart(url) {
    const attempts = [url, PROXY_RAW(url)];
    let lastErr = null;
    for (const u of attempts) {
      try {
        const res = await fetchWithTimeout(u, { timeoutMs: 20000 });
        if (!res.ok) throw new Error("bad_response");
        const text = await res.text();
        if (text && text.length > 80) return text;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("fetch_failed");
  }

  // RSS parsing XML + fallback RSS2JSON
  function parseFeedXML(xmlText, source) {
    const doc = new DOMParser().parseFromString(xmlText, "text/xml");
    if (doc.querySelector("parsererror")) return [];
    const items = Array.from(doc.querySelectorAll("item"));
    if (!items.length) return [];

    const getText = (p, sel) => (p.querySelector(sel)?.textContent || "").trim();
    const getAttr = (p, sel, attr) => (p.querySelector(sel)?.getAttribute(attr) || "").trim();

    const out = [];
    for (const item of items.slice(0, MAX_PER_SOURCE)) {
      const title = getText(item, "title");
      const link = getText(item, "link") || getText(item, "guid");
      const pubRaw = getText(item, "pubDate") || getText(item, "dc\\:date") || getText(item, "published") || "";
      const html = getText(item, "content\\:encoded") || getText(item, "description") || "";
      const desc = stripHtml(html);

      const mediaContent = getAttr(item, "media\\:content", "url");
      const mediaThumb = getAttr(item, "media\\:thumbnail", "url");
      const enclosure = getAttr(item, "enclosure", "url");
      const itunesImg = getAttr(item, "itunes\\:image", "href");
      const rssImage = firstGoodUrl([mediaContent, mediaThumb, enclosure, itunesImg], link);

      out.push({
        id: link || `${source.id}-${Math.random().toString(16).slice(2)}`,
        title: title || "بدون عنوان",
        link: link || "#",
        pubDate: toISOStringSafe(pubRaw || Date.now()),
        source: source.name,
        sourceHome: source.homepage,
        description: desc,
        image: rssImage || "",
        category: guessCategory(`${title} ${desc}`),
        _sourceId: source.id,
        _needsImageFromPage: true
      });
    }
    return out;
  }

  function normalizeRss2JsonItem(item, source) {
    const title = item.title || "بدون عنوان";
    const link = item.link || item.guid || "#";
    const pub = item.pubDate || item.published || new Date().toISOString();
    const desc = stripHtml(item.description || item.content || "");
    const rssImage = firstGoodUrl([item.thumbnail, item.enclosure?.link], link);

    return {
      id: link || `${source.id}-${Math.random().toString(16).slice(2)}`,
      title,
      link,
      pubDate: toISOStringSafe(pub),
      source: source.name,
      sourceHome: source.homepage,
      description: desc,
      image: rssImage || "",
      category: guessCategory(`${title} ${desc}`),
      _sourceId: source.id,
      _needsImageFromPage: true
    };
  }

  async function fetchFeedItems(source) {
    // XML
    try {
      const xml = await fetchTextSmart(source.rss);
      const items = parseFeedXML(xml, source);
      if (items.length) return items;
    } catch {}

    // RSS2JSON fallback
    try {
      const res = await fetchWithTimeout(RSS2JSON(source.rss), { timeoutMs: 20000 });
      if (!res.ok) throw new Error("rss2json_bad");
      const json = await res.json();
      const items = Array.isArray(json.items) ? json.items : [];
      return items.slice(0, MAX_PER_SOURCE).map(it => normalizeRss2JsonItem(it, source));
    } catch {
      return [];
    }
  }

  // Image from inside the news page
  function extractOgImageFromHtml(html, pageUrl) {
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const og = doc.querySelector('meta[property="og:image"], meta[property="og:image:secure_url"]')?.getAttribute("content");
      const tw = doc.querySelector('meta[name="twitter:image"], meta[name="twitter:image:src"]')?.getAttribute("content");
      const linkImageSrc = doc.querySelector('link[rel="image_src"]')?.getAttribute("href");

      const metaPick = firstGoodUrl([og, tw, linkImageSrc], pageUrl);
      if (metaPick) return metaPick;

      const imgs = Array.from(doc.images || []);
      for (const img of imgs) {
        const src = img.getAttribute("src") || img.getAttribute("data-src") || img.getAttribute("data-lazy-src");
        const abs = resolveUrl(src, pageUrl);
        if (!abs || !abs.startsWith("https://")) continue;

        const w = parseInt(img.getAttribute("width") || "0", 10);
        const h = parseInt(img.getAttribute("height") || "0", 10);
        const alt = (img.getAttribute("alt") || "").toLowerCase();

        const looksLikeIcon = abs.includes("logo") || abs.includes("icon") || alt.includes("logo");
        if (looksLikeIcon) continue;
        if ((w && w < 140) || (h && h < 140)) continue;

        return abs;
      }
    } catch {}

    // Regex fallback
    const m1 = String(html).match(/property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["']/i);
    if (m1?.[1]) return resolveUrl(m1[1], pageUrl);
    const m2 = String(html).match(/name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i);
    if (m2?.[1]) return resolveUrl(m2[1], pageUrl);

    return "";
  }

  // Translate to Arabic for non-Arabic items
  async function translateToArabic(text) {
    const t = String(text || "").trim();
    if (!t) return "";
    if (isArabicText(t)) return t;

    const limited = t.length > 600 ? t.slice(0, 600) : t;

    try {
      const res = await fetch(TRANSLATE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: limited, source: "auto", target: "ar", format: "text" })
      });

      if (!res.ok) throw new Error("translate_failed");
      const json = await res.json();
      return (json.translatedText || "").trim() || t;
    } catch {
      return t;
    }
  }

  // Async pool
  async function asyncPool(limit, arr, iteratorFn) {
    const ret = [];
    const executing = [];
    for (const item of arr) {
      const p = Promise.resolve().then(() => iteratorFn(item));
      ret.push(p);
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) await Promise.race(executing);
    }
    return Promise.all(ret);
  }

  // Enrich: page image + translation
  async function enrichArticle(article) {
    const a = { ...article };

    if (a._needsImageFromPage && a.link && a.link.startsWith("http")) {
      try {
        const html = await fetchTextSmart(a.link);
        const pageImage = extractOgImageFromHtml(html, a.link);
        if (pageImage) a.image = pageImage;
      } catch {}
    }

    a.title = await translateToArabic(a.title);
    a.description = await translateToArabic(a.description);
    a.category = guessCategory(`${a.title} ${a.description}`);

    delete a._needsImageFromPage;
    return a;
  }

  // Round-robin mix to ensure multiple sources appear
  function interleaveBySource(items) {
    const groups = new Map();
    for (const it of items) {
      const key = it._sourceId || it.source;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }

    for (const [k, arr] of groups.entries()) {
      groups.set(k, sortItems(arr, "new").slice(0, MAX_PER_SOURCE));
    }

    const keys = Array.from(groups.keys());
    const out = [];
    let added = true;

    while (out.length < MAX_TOTAL_ARTICLES && added) {
      added = false;
      for (const k of keys) {
        const arr = groups.get(k);
        if (arr && arr.length) {
          out.push(arr.shift());
          added = true;
          if (out.length >= MAX_TOTAL_ARTICLES) break;
        }
      }
    }

    return out;
  }

  // Rendering
  function categoryLabel(cat) {
    switch (cat) {
      case "research": return "أبحاث";
      case "companies": return "شركات";
      case "products": return "منتجات";
      case "policy": return "تشريعات";
      case "security": return "أمان";
      default: return "عام";
    }
  }

  function renderCard(article, { compact = false } = {}) {
    const title = escapeHtml(article.title);
    const desc = escapeHtml(clampText(article.description || "", compact ? 130 : 170));
    const date = escapeHtml(toArabicDateTime(article.pubDate));
    const source = escapeHtml(article.source || "—");
    const cat = categoryLabel(article.category);

    const img = article.image ? escapeHtml(article.image) : "";
    const noImageClass = img ? "" : "no-image";
    const mediaHtml = img ? `<img src="${img}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : "";

    return `
      <article class="card news-card">
        <div class="news-card__media ${noImageClass}">
          ${mediaHtml}
          <span class="news-card__badge">${cat}</span>
        </div>

        <div class="news-card__content">
          <div>
            <h3 class="news-card__title">
              <a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer">${title}</a>
            </h3>
            <p class="news-card__desc">${desc || "—"}</p>
          </div>

          <div class="news-card__meta">
            <span><span class="kbd">المصدر</span> <span class="sep">•</span> ${source}</span>
            <span><span class="kbd">التاريخ</span> <span class="sep">•</span> ${date}</span>
          </div>
        </div>
      </article>
    `;
  }

  function render() {
    const items = state.filtered;

    el.newsGrid.innerHTML = items.length
      ? items.map((a) => renderCard(a)).join("")
      : `<div class="status">لا توجد أخبار متاحة الآن. حاول التحديث بعد قليل.</div>`;

    const highlights = sortItems(state.articles, "new").slice(0, 3);
    el.highlightsGrid.innerHTML = highlights.length
      ? highlights.map((a) => renderCard(a, { compact: true })).join("")
      : `<div class="status">—</div>`;

    el.totalCount.textContent = String(state.articles.length);
    el.sourceCount.textContent = String(SOURCES.length);

    // إذا فشل تحميل الصورة: أزلها وأظهر شكل افتراضي
    document.querySelectorAll(".news-card__media img").forEach((img) => {
      if (img.dataset.wired === "1") return;
      img.dataset.wired = "1";
      img.addEventListener("error", () => {
        const media = img.closest(".news-card__media");
        img.remove();
        media?.classList.add("no-image");
      });
    });
  }

  function applyFiltersAndRender() {
    const q = state.query.trim().toLowerCase();
    const cat = state.category;

    let filtered = [...state.articles];
    if (cat !== "all") filtered = filtered.filter(a => a.category === cat);
    if (q) filtered = filtered.filter(a => (`${a.title} ${a.description} ${a.source}`.toLowerCase()).includes(q));

    filtered = sortItems(filtered, state.sort);
    state.filtered = filtered;

    render();
    updateMetaUI();
  }

  // Timers
  let countdownTimer = null;
  let autoUpdateTimer = null;

  function updateMetaUI() {
    const last = state.lastFetchAt || 0;
    if (!last) {
      el.lastUpdated.textContent = "—";
      el.nextUpdate.textContent = "—";
      return;
    }
    el.lastUpdated.textContent = toArabicDateTime(new Date(last).toISOString());
    const nextAt = last + UPDATE_INTERVAL_MS;
    el.nextUpdate.textContent = formatCountdown(nextAt - Date.now());
  }

  function startCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      if (!state.lastFetchAt) return;
      const nextAt = state.lastFetchAt + UPDATE_INTERVAL_MS;
      const msLeft = nextAt - Date.now();
      el.nextUpdate.textContent = formatCountdown(msLeft);
      if (msLeft <= 0 && !state.loading) updateNews({ force: true });
    }, 1000);
  }

  function scheduleNextAutoUpdate() {
    if (autoUpdateTimer) clearTimeout(autoUpdateTimer);
    if (!state.lastFetchAt) return;
    const nextAt = state.lastFetchAt + UPDATE_INTERVAL_MS;
    const msLeft = Math.max(2000, nextAt - Date.now());
    autoUpdateTimer = setTimeout(() => updateNews({ force: true }), msLeft);
  }

  // Update
  async function updateNews({ force = false } = {}) {
    if (state.loading) return;
    state.loading = true;

    try {
      setStatus("جارٍ تحديث الأخبار…");
      el.cachedBadge.textContent = "مباشر";

      const cached = readCache();
      if (!force && cached && !isStale(cached.lastFetchAt) && cached.articles?.length) {
        state.articles = cached.articles;
        state.lastFetchAt = cached.lastFetchAt;
        el.cachedBadge.textContent = "محفوظ";
        setStatus("تم عرض آخر تحديث متاح.");
        applyFiltersAndRender();
        return;
      }

      setStatus("جارٍ جلب الأخبار من مصادر متعددة…");
      const settled = await Promise.allSettled(SOURCES.map(fetchFeedItems));

      let items = [];
      for (const r of settled) if (r.status === "fulfilled") items.push(...r.value);
      items = uniqueByLink(items);

      if (!items.length) {
        if (cached?.articles?.length) {
          state.articles = cached.articles;
          state.lastFetchAt = cached.lastFetchAt || 0;
          el.cachedBadge.textContent = "محفوظ";
          setStatus("تعذر التحديث الآن. تم عرض آخر أخبار متاحة.");
          applyFiltersAndRender();
          showToast("تعذر التحديث الآن");
          return;
        }

        state.articles = [];
        state.lastFetchAt = Date.now();
        el.cachedBadge.textContent = "—";
        setStatus("تعذر تحميل الأخبار الآن. حاول لاحقاً.");
        applyFiltersAndRender();
        showToast("تعذر تحميل الأخبار");
        return;
      }

      // Mix sources (Round-robin)
      items = interleaveBySource(sortItems(items, "new"));

      setStatus("جارٍ تجهيز الأخبار للعرض…");
      const enriched = await asyncPool(CONCURRENCY, items, enrichArticle);

      state.articles = sortItems(enriched, "new");
      state.lastFetchAt = Date.now();

      writeCache({ lastFetchAt: state.lastFetchAt, articles: state.articles });

      el.cachedBadge.textContent = "مباشر";
      setStatus(`تم التحديث. عدد الأخبار: ${state.articles.length}`);
      showToast("تم تحديث الأخبار ✅");
      applyFiltersAndRender();
    } catch {
      const cached = readCache();
      if (cached?.articles?.length) {
        state.articles = cached.articles;
        state.lastFetchAt = cached.lastFetchAt || 0;
        el.cachedBadge.textContent = "محفوظ";
        setStatus("تعذر التحديث الآن. تم عرض آخر أخبار متاحة.");
        applyFiltersAndRender();
      } else {
        state.articles = [];
        state.lastFetchAt = Date.now();
        el.cachedBadge.textContent = "—";
        setStatus("تعذر تحميل الأخبار الآن. حاول لاحقاً.");
        applyFiltersAndRender();
      }
      showToast("حدثت مشكلة أثناء التحديث");
    } finally {
      state.loading = false;
      updateMetaUI();
      scheduleNextAutoUpdate();
    }
  }

  // Sources UI
  function renderSources() {
    el.sourceList.innerHTML = SOURCES.map(s => `
      <li>
        <div>
          <strong>${escapeHtml(s.name)}</strong>
          <div><small>${escapeHtml(s.homepage)}</small></div>
        </div>
        <a class="btn btn--ghost" href="${escapeHtml(s.homepage)}" target="_blank" rel="noopener noreferrer">زيارة</a>
      </li>
    `).join("");
  }

  // Events
  function setupEvents() {
    el.refreshBtn.addEventListener("click", () => updateNews({ force: true }));

    el.sortSelect.addEventListener("change", (e) => {
      state.sort = e.target.value;
      applyFiltersAndRender();
    });

    el.searchForm.addEventListener("submit", (e) => {
      e.preventDefault();
      state.query = el.searchInput.value || "";
      applyFiltersAndRender();
    });

    el.chips.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-category]");
      if (!btn) return;
      [...el.chips.querySelectorAll(".chip")].forEach(x => x.classList.remove("is-active"));
      btn.classList.add("is-active");
      state.category = btn.dataset.category;
      applyFiltersAndRender();
    });

    el.subscribeForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const email = (el.emailInput.value || "").trim();
      if (!email) return;
      const prefs = readPrefs();
      prefs.savedEmail = email;
      writePrefs(prefs);
      el.emailInput.value = "";
      showToast("تم حفظ البريد ✅");
    });

    el.themeToggle.addEventListener("click", () => {
      document.body.classList.toggle("dark");
      const prefs = readPrefs();
      prefs.darkMode = document.body.classList.contains("dark");
      writePrefs(prefs);
      el.themeToggle.textContent = document.body.classList.contains("dark") ? "الوضع الفاتح" : "الوضع الداكن";
    });
  }

  // Init
  function init() {
    renderSources();

    const prefs = readPrefs();
    if (prefs.darkMode) {
      document.body.classList.add("dark");
      el.themeToggle.textContent = "الوضع الفاتح";
    }

    const cached = readCache();
    if (cached?.articles?.length) {
      state.articles = cached.articles;
      state.lastFetchAt = cached.lastFetchAt || 0;
      el.cachedBadge.textContent = "محفوظ";
      setStatus("تم عرض آخر تحديث متاح.");
      applyFiltersAndRender();
    } else {
      el.cachedBadge.textContent = "—";
      setStatus("جارٍ تحميل الأخبار…");
    }

    setupEvents();
    startCountdown();

    if (!cached || isStale(cached.lastFetchAt)) {
      updateNews({ force: true });
    } else {
      updateMetaUI();
      scheduleNextAutoUpdate();
    }
  }

  init();
})();

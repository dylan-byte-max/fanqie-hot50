/**
 * 番茄小说热门榜单爬虫 v2
 * 
 * 多源数据融合策略：
 * 1. top_book_list/v1 API  → 未加密的排名列表（书名、作者、分类、封面）
 * 2. category_list/v0 API  → 分类名→性别频道映射
 * 3. book_list/v0 API      → 排名顺序（按最热排序，有字数/状态等字段，但加密）
 * 4. 详情页 meta 标签      → 未加密的简介、作者确认
 * 5. 详情页 JSON-LD        → 作者、更新时间、高清封面
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ========== 配置 ==========
const DATA_DIR = path.join(__dirname, 'data');
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};
const TARGET_COUNT = 50;
const PAGE_SIZE = 18;
const REQUEST_DELAY = 600;

// ========== 工具函数 ==========
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { ...HEADERS, ...extraHeaders }, timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

function getNowBJT() {
  const now = new Date();
  return new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
}
function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function fmtDateTime(d) {
  return `${fmtDate(d)} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}
function formatWordCount(n) {
  if (!n || n <= 0) return '未知';
  n = Number(n);
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  return String(n);
}

// ========== 步骤1: 获取分类 → 性别映射 ==========
async function buildCategoryGenderMap() {
  console.log('  获取分类列表...');
  const map = {};
  for (const g of [1, 0]) {
    try {
      const url = `https://fanqienovel.com/api/author/book/category_list/v0/?gender=${g}`;
      const res = await httpGet(url, { Accept: 'application/json' });
      const json = JSON.parse(res.data);
      if (json.code === 0 && json.data) {
        for (const cat of json.data) {
          map[cat.name] = { gender: g === 1 ? '男频' : '女频', id: cat.category_id };
        }
      }
    } catch (e) { console.log(`  [WARN] 分类获取失败(g=${g}): ${e.message}`); }
    await sleep(300);
  }
  return map;
}

// ========== 步骤2: 获取热榜排名列表（加密但有正确排序） ==========
async function fetchHotRankList() {
  console.log('  获取热榜排名...');
  const allBooks = [];
  const pagesNeeded = Math.ceil(TARGET_COUNT / PAGE_SIZE);
  for (let page = 0; page < pagesNeeded; page++) {
    const params = new URLSearchParams({
      page_count: PAGE_SIZE, page_index: page,
      gender: -1, category_id: -1, creation_status: -1,
      word_count: -1, book_type: -1, sort: 0,
    });
    try {
      const res = await httpGet(
        `https://fanqienovel.com/api/author/library/book_list/v0/?${params}`,
        { Accept: 'application/json' }
      );
      const json = JSON.parse(res.data);
      if (json.code === 0 && json.data?.book_list) {
        allBooks.push(...json.data.book_list);
      }
    } catch (e) { console.log(`  [WARN] 第${page+1}页失败: ${e.message}`); }
    if (page < pagesNeeded - 1) await sleep(REQUEST_DELAY);
  }
  return allBooks.slice(0, TARGET_COUNT);
}

// ========== 步骤3: 获取 top_book_list（未加密的精选列表） ==========
async function fetchTopBookList() {
  console.log('  获取TOP推荐列表（未加密）...');
  try {
    const res = await httpGet(
      'https://fanqienovel.com/api/author/misc/top_book_list/v1/',
      { Accept: 'application/json' }
    );
    const json = JSON.parse(res.data);
    if (json.book_list) {
      const map = {};
      for (const b of json.book_list) {
        map[String(b.book_id)] = {
          book_name: b.book_name,
          author: b.author,
          category: b.category,
          creation_status: b.creation_status,
          thumb_url: b.thumb_url,
        };
      }
      console.log(`  → 获取到 ${Object.keys(map).length} 本未加密数据`);
      return map;
    }
  } catch (e) { console.log(`  [WARN] top_book_list失败: ${e.message}`); }
  return {};
}

// ========== 步骤4: 从详情页获取丰富信息 ==========
function parseDetailPage(html) {
  const info = {};
  const tm = html.match(/<title>(.*?)<\/title>/);
  if (tm) {
    const nm = tm[1].match(/^(.+?)(?:完整版|全文|_)/);
    if (nm) info.book_name = nm[1].trim();
  }
  const dm = html.match(/<meta\s+name="description"\s+content="([^"]*)"/);
  if (dm) {
    info.description = dm[1].replace(/^番茄小说提供.*?番茄小说网[。.]?\s*/, '').trim();
  }
  const km = html.match(/<meta\s+name="keywords"\s+content="([^"]*)"/);
  if (km) {
    const am = km[1].match(/,([^,]+?)小说/);
    if (am && !/免费|阅读|章节|下载/.test(am[1])) {
      info.author = am[1].trim();
    }
  }
  const ldm = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
  if (ldm) {
    try {
      const ld = JSON.parse(ldm[1]);
      if (!info.author && ld.author?.[0]?.name) info.author = ld.author[0].name;
      if (ld.dateModified) info.dateModified = ld.dateModified;
      if (ld.image?.[0]) info.hdImage = ld.image[0];
    } catch(e) {}
  }
  return info;
}

// ========== 步骤5: 男频/女频细分分类 ==========
async function fetchGenderForBooks(bookIds) {
  console.log('  精确判断男频/女频...');
  const result = {};
  
  for (let pageIdx = 0; pageIdx < 3; pageIdx++) {
    for (const gender of [1, 0]) {
      const gLabel = gender === 1 ? '男频' : '女频';
      const params = new URLSearchParams({
        page_count: 18, page_index: pageIdx,
        gender, category_id: -1, creation_status: -1,
        word_count: -1, book_type: -1, sort: 0,
      });
      try {
        const res = await httpGet(
          `https://fanqienovel.com/api/author/library/book_list/v0/?${params}`,
          { Accept: 'application/json' }
        );
        const json = JSON.parse(res.data);
        if (json.code === 0 && json.data?.book_list) {
          for (const b of json.data.book_list) {
            if (!result[String(b.book_id)]) result[String(b.book_id)] = gLabel;
          }
        }
      } catch(e) {}
      await sleep(500);
    }
  }
  
  return result;
}

// ========== 主函数 ==========
async function main() {
  const now = getNowBJT();
  console.log('='.repeat(60));
  console.log(`番茄小说热门榜单爬虫 v2 - ${fmtDateTime(now)}`);
  console.log('='.repeat(60));

  ensureDir(DATA_DIR);
  ensureDir(path.join(DATA_DIR, 'history'));

  console.log('\n📊 阶段一：获取基础数据');
  const [hotRankList, topBookMap, catGenderMap, genderByBookId] = await Promise.all([
    fetchHotRankList(),
    fetchTopBookList(),
    buildCategoryGenderMap(),
    fetchGenderForBooks(),
  ]);

  console.log(`  热榜: ${hotRankList.length} 本 | TOP推荐: ${Object.keys(topBookMap).length} 本`);
  console.log(`  分类: ${Object.keys(catGenderMap).length} 个 | 性别确认: ${Object.keys(genderByBookId).length} 本`);

  console.log(`\n📖 阶段二：获取 ${hotRankList.length} 本书详情`);
  const books = [];

  for (let i = 0; i < hotRankList.length; i++) {
    const rawBook = hotRankList[i];
    const bookId = String(rawBook.book_id);
    const rank = i + 1;

    const topInfo = topBookMap[bookId] || {};

    process.stdout.write(`  [${rank}/${hotRankList.length}] `);

    let detailInfo = {};
    try {
      const res = await httpGet(`https://fanqienovel.com/page/${bookId}`);
      detailInfo = parseDetailPage(res.data);
      process.stdout.write(`✓ `);
    } catch(e) {
      process.stdout.write(`✗ `);
    }

    const bookName = topInfo.book_name || detailInfo.book_name || `ID:${bookId}`;
    const author = topInfo.author || detailInfo.author || '未知';
    const category = topInfo.category || '';
    const creationStatus = topInfo.creation_status ?? rawBook.creation_status;
    const statusLabel = creationStatus === 0 ? '完结' : (creationStatus === 1 ? '连载中' : '未知');

    let gender = genderByBookId[bookId] || '未知';
    if (gender === '未知' && category && catGenderMap[category]) {
      gender = catGenderMap[category].gender;
    }

    const tags = [];
    if (category) tags.push(category);

    const abstract = detailInfo.description || '暂无简介';

    const thumbUrl = detailInfo.hdImage || topInfo.thumb_url || rawBook.thumb_url || '';

    console.log(bookName);

    books.push({
      rank,
      book_id: bookId,
      book_name: bookName,
      author,
      gender,
      tags,
      abstract,
      status: statusLabel,
      first_publish_time: '未知',
      thumb_url: thumbUrl,
      book_url: `https://fanqienovel.com/page/${bookId}`,
      rank_change: null,
    });

    if (i < hotRankList.length - 1) await sleep(REQUEST_DELAY);
  }

  console.log('\n📈 阶段三：计算排名变化');
  const latestPath = path.join(DATA_DIR, 'latest.json');
  let prevData = null;
  if (fs.existsSync(latestPath)) {
    try { prevData = JSON.parse(fs.readFileSync(latestPath, 'utf-8')); } catch(e) {}
  }

  if (prevData?.books) {
    const prevMap = {};
    for (const b of prevData.books) prevMap[b.book_id] = b.rank;
    for (const b of books) {
      if (b.book_id in prevMap) {
        b.rank_change = prevMap[b.book_id] - b.rank;
      } else {
        b.rank_change = 'new';
      }
    }
    console.log('  已对比历史数据');
  } else {
    for (const b of books) b.rank_change = 'new';
    console.log('  无历史数据，全部标记为新');
  }

  const result = {
    update_time: fmtDateTime(now),
    update_date: fmtDate(now),
    total_count: books.length,
    source: '番茄小说书库·最热榜',
    source_url: 'https://fanqienovel.com/library?enter_from=menu',
    books,
  };

  fs.writeFileSync(latestPath, JSON.stringify(result, null, 2), 'utf-8');
  const histPath = path.join(DATA_DIR, 'history', `${fmtDate(now)}.json`);
  fs.writeFileSync(histPath, JSON.stringify(result, null, 2), 'utf-8');

  const idxPath = path.join(DATA_DIR, 'history_index.json');
  let idx = [];
  if (fs.existsSync(idxPath)) { try { idx = JSON.parse(fs.readFileSync(idxPath, 'utf-8')); } catch(e){} }
  const today = fmtDate(now);
  if (!idx.includes(today)) idx.unshift(today);
  idx = idx.slice(0, 90);
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2), 'utf-8');

  const genderStats = {};
  for (const b of books) { genderStats[b.gender] = (genderStats[b.gender]||0) + 1; }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`🎉 完成！共 ${books.length} 本`);
  console.log(`   性别分布: ${JSON.stringify(genderStats)}`);
  console.log(`   数据: ${latestPath}`);
  console.log(`   历史: ${histPath}`);
}

main().catch(e => {
  console.error('致命错误:', e);
  // 如果有历史数据，不算致命失败（下次再重试就好）
  const latestPath = path.join(__dirname, 'data', 'latest.json');
  if (fs.existsSync(latestPath)) {
    console.log('⚠️ 爬虫本次运行失败，但已有历史数据可用，退出码 0');
    process.exit(0);
  } else {
    process.exit(1);
  }
});

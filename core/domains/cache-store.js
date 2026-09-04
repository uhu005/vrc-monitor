export class CacheStore {
  constructor(storage) {
    this.storage = storage;
  }

  getZhTranslations(worldIds) {
    if (!worldIds || worldIds.length === 0) return new Map();
    const params = {};
    const ph = worldIds.map((id, i) => { params[`$w${i}`] = id; return `$w${i}`; }).join(',');
    const rows = this.storage.query(`SELECT world_id, zh FROM world_zh_translations WHERE world_id IN (${ph})`, params);
    const map = new Map();
    for (const r of rows) map.set(r.world_id, r.zh);
    return map;
  }

  setZhTranslation(worldId, zh) {
    this.storage.run(
      `INSERT INTO world_zh_translations (world_id, zh, updated_at) VALUES ($worldId, $zh, datetime('now'))
       ON CONFLICT(world_id) DO UPDATE SET zh = $zh, updated_at = datetime('now')`,
      { $worldId: worldId, $zh: zh }
    );
  }

  getGroupCached(groupId) {
    const rows = this.storage.query(`SELECT * FROM group_cache WHERE group_id = $g`, { $g: groupId });
    return rows[0] || null;
  }

  upsertGroupCache({ groupId, name, description, memberCount }) {
    this.storage.run(
      `INSERT INTO group_cache (group_id, name, description, member_count, updated_at)
       VALUES ($g, $name, $desc, $mc, datetime('now'))
       ON CONFLICT(group_id) DO UPDATE SET
         name = excluded.name, description = excluded.description,
         member_count = excluded.member_count, updated_at = datetime('now')`,
      { $g: groupId, $name: name || '', $desc: description || '', $mc: memberCount || 0 }
    );
  }

  getPlanetCache(key, ttlMs) {
    const rows = this.storage.query(`SELECT payload, fetched_at FROM planet_cache WHERE key = $key`, { $key: key });
    if (rows.length === 0) return null;
    const row = rows[0];
    if (ttlMs && row.fetched_at) {
      const fetchedMs = Date.parse(row.fetched_at);
      if (Number.isFinite(fetchedMs) && Date.now() - fetchedMs > ttlMs) return null;
    }
    try { return JSON.parse(row.payload); } catch { return null; }
  }

  setPlanetCache(key, payload) {
    this.storage.run(
      `INSERT INTO planet_cache (key, payload, fetched_at)
       VALUES ($key, $payload, $fetchedAt)
       ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
      { $key: key, $payload: JSON.stringify(payload), $fetchedAt: new Date().toISOString() }
    );
  }

  getGroupHeat(startIso, endIso) {
    const rows = this.storage.query(
      `SELECT type, content_json, created_at FROM events
       WHERE (type='friend-location' OR type='user-location')
         AND created_at >= $start AND created_at <= $end
         AND (content_json LIKE '%~group(grp_%' OR content_json LIKE '%~group(gmem_%')
       ORDER BY created_at ASC`,
      { $start: startIso, $end: endIso }
    );
    const groups = new Map();
    for (const row of rows) {
      try {
        const c = JSON.parse(row.content_json);
        const loc = c.location || '';
        const m = loc.match(/~group\((grp_[a-f0-9-]+|gmem_[a-f0-9-]+)\)/);
        if (!m || !loc.startsWith('wrld_')) continue;
        const gid = m[1];
        if (!groups.has(gid)) groups.set(gid, { count: 0, users: new Set(), worlds: new Set(), hourly: new Map() });
        const s = groups.get(gid);
        s.count++;
        s.users.add(c.userId || '');
        s.worlds.add(loc.split(':')[0]);
        const d = new Date(row.created_at);
        if (!Number.isNaN(d.getTime())) {
          const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000);
          const key = `${bj.getUTCDay()}:${bj.getUTCHours()}`;
          s.hourly.set(key, (s.hourly.get(key) || 0) + 1);
        }
      } catch {}
    }
    return groups;
  }

  upsertBoothItem(item) {
    this.storage.run(
      `INSERT INTO booth_items (id, name, price, wishlist_count, shop_name, description, tags, image_url, url, published_at, is_sold_out, updated_at)
       VALUES ($id, $name, $price, $wishlist, $shop, $desc, $tags, $img, $url, $published, $soldOut, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, price = excluded.price, wishlist_count = excluded.wishlist_count,
         shop_name = excluded.shop_name, description = excluded.description, tags = excluded.tags,
         image_url = excluded.image_url, url = excluded.url, published_at = excluded.published_at,
         is_sold_out = excluded.is_sold_out, updated_at = datetime('now')`,
      {
        $id: String(item.id),
        $name: item.name || '',
        $price: item.price || '',
        $wishlist: item.wishlistCount ?? 0,
        $shop: (item.shop && item.shop.name) || '',
        $desc: (item.description || '').slice(0, 2000),
        $tags: JSON.stringify(item.tags || []),
        $img: (item.images && item.images[0] && item.images[0].original) || '',
        $url: item.url || '',
        $published: item.publishedAt || '',
        $soldOut: item.isSoldOut ? 1 : 0,
      }
    );
  }

  getBoothItemCache(id) {
    const rows = this.storage.query(
      `SELECT id, name, price, wishlist_count AS wishlistCount, shop_name AS shopName,
              description, tags, image_url AS imageUrl, url, published_at AS publishedAt,
              is_sold_out AS isSoldOut, updated_at AS updatedAt
       FROM booth_items WHERE id = $id`,
      { $id: String(id) }
    );
    const r = rows[0];
    if (!r) return null;
    try { r.tags = JSON.parse(r.tags || '[]'); } catch { r.tags = []; }
    return r;
  }

  listBoothItems({ sortBy = 'wishlist', limit = 20, minWishlist = 0 } = {}) {
    const order = sortBy === 'wishlist' ? 'wishlist_count DESC' : 'updated_at DESC';
    const rows = this.storage.query(
      `SELECT id, name, price, wishlist_count AS wishlistCount, shop_name AS shopName,
              image_url AS imageUrl, url, is_sold_out AS isSoldOut, updated_at AS updatedAt
       FROM booth_items WHERE wishlist_count >= $minWishlist
       ORDER BY ${order} LIMIT $limit`,
      { $minWishlist: minWishlist, $limit: Math.max(1, Math.min(100, limit)) }
    );
    return rows;
  }

  recordBoothSearch(query, resultIds) {
    this.storage.run(
      `INSERT INTO booth_search_history (query, result_ids, result_count, created_at)
       VALUES ($query, $ids, $count, datetime('now'))`,
      { $query: query, $ids: JSON.stringify(resultIds || []), $count: (resultIds || []).length }
    );
  }

  getBoothSearches({ limit = 10 } = {}) {
    const rows = this.storage.query(
      `SELECT id, query, result_ids AS resultIds, result_count AS resultCount, created_at AS createdAt
       FROM booth_search_history ORDER BY id DESC LIMIT $limit`,
      { $limit: Math.max(1, Math.min(50, limit)) }
    );
    for (const r of rows) {
      try { r.resultIds = JSON.parse(r.resultIds || '[]'); } catch { r.resultIds = []; }
    }
    return rows;
  }
}

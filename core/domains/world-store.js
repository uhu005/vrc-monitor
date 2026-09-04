export class WorldStore {
  constructor(storage) {
    this.storage = storage;
  }

  getWorldName(worldId) {
    const rows = this.storage.query(`SELECT * FROM world_cache WHERE world_id = $worldId`, { $worldId: worldId });
    return rows[0] || null;
  }

  searchWorldsByName(keyword) {
    const like = `%${keyword}%`;
    const rows = this.storage.query(
      `SELECT world_id, name FROM world_cache WHERE name LIKE $like ORDER BY name LIMIT 20`,
      { $like: like }
    );
    const eventRows = this.storage.query(
      `SELECT world_id, world_name AS name FROM events WHERE world_name LIKE $like AND world_id != '' GROUP BY world_id, world_name ORDER BY world_name LIMIT 20`,
      { $like: like }
    );
    const seen = new Set();
    const merged = [];
    for (const r of [...rows, ...eventRows]) {
      if (!r.world_id || seen.has(r.world_id)) continue;
      seen.add(r.world_id);
      merged.push({ worldId: r.world_id, name: r.name || '' });
    }
    return merged;
  }

  _recordWorldChanges(world) {
    const old = this.getWorldName(world.worldId);
    if (!old) return;
    const fieldMap = {
      name: 'name',
      description: 'description',
      author_name: 'authorName',
      image_url: 'imageUrl',
      release_status: 'releaseStatus',
      capacity: 'capacity',
      tags: 'tags',
    };
    const fields = ['name', 'description', 'author_name', 'image_url', 'release_status', 'capacity', 'tags'];
    const newTags = JSON.stringify(world.tags || []);
    for (const f of fields) {
      const oldValue = f === 'tags' ? String(old.tags ?? '') : String(old[f] ?? '');
      const newValue = f === 'tags' ? newTags : String(world[fieldMap[f]] ?? '');
      if (oldValue !== newValue) {
        this.storage.run(
          `INSERT INTO world_history (world_id, field, old_value, new_value)
           VALUES ($worldId, $field, $oldValue, $newValue)`,
          { $worldId: world.worldId, $field: f, $oldValue: oldValue, $newValue: newValue }
        );
      }
    }
  }

  upsertWorld(world) {
    this._recordWorldChanges(world);
    this.storage.run(
      `INSERT INTO world_cache
       (world_id, name, author_id, author_name, description, image_url,
        release_status, capacity, favorites, tags, updated_at)
       VALUES ($worldId, $name, $authorId, $authorName, $description, $imageUrl,
        $releaseStatus, $capacity, $favorites, $tags, datetime('now'))
       ON CONFLICT(world_id) DO UPDATE SET
        name = excluded.name,
        author_id = excluded.author_id,
        author_name = excluded.author_name,
        description = excluded.description,
        image_url = excluded.image_url,
        release_status = excluded.release_status,
        capacity = excluded.capacity,
        favorites = excluded.favorites,
        tags = excluded.tags,
        updated_at = datetime('now')`,
      {
        $worldId: world.worldId, $name: world.name || '',
        $authorId: world.authorId || '', $authorName: world.authorName || '',
        $description: world.description || '', $imageUrl: world.imageUrl || '',
        $releaseStatus: world.releaseStatus || '',
        $capacity: world.capacity || 0, $favorites: world.favorites || 0,
        $tags: JSON.stringify(world.tags || []),
      }
    );
  }

  upsertWorldsBatch(worlds) {
    for (const w of worlds) {
      this._recordWorldChanges(w);
    }
    const stmt = this.storage.db.prepare(
      `INSERT INTO world_cache
       (world_id, name, author_id, author_name, description, image_url,
        release_status, capacity, favorites, tags, updated_at)
       VALUES ($worldId, $name, $authorId, $authorName, $description, $imageUrl,
        $releaseStatus, $capacity, $favorites, $tags, datetime('now'))
       ON CONFLICT(world_id) DO UPDATE SET
        name = excluded.name,
        author_id = excluded.author_id,
        author_name = excluded.author_name,
        description = excluded.description,
        image_url = excluded.image_url,
        release_status = excluded.release_status,
        capacity = excluded.capacity,
        favorites = excluded.favorites,
        tags = excluded.tags,
        updated_at = datetime('now')`
    );
    for (const w of worlds) {
      stmt.run(this.storage._normParams({
        $worldId: w.worldId, $name: w.name || '',
        $authorId: w.authorId || '', $authorName: w.authorName || '',
        $description: w.description || '', $imageUrl: w.imageUrl || '',
        $releaseStatus: w.releaseStatus || '',
        $capacity: w.capacity || 0, $favorites: w.favorites || 0,
        $tags: JSON.stringify(w.tags || []),
      }));
    }
  }

  setWorldNote({ worldId, note = '' }) {
    this.storage.run(
      `INSERT INTO world_cache (world_id, name, note)
       VALUES ($worldId, '', $note)
       ON CONFLICT(world_id) DO UPDATE SET note = $note, updated_at = datetime('now')`,
      { $worldId: worldId, $note: note }
    );
    const rows = this.storage.query(`SELECT world_id, note FROM world_cache WHERE world_id = $worldId`, { $worldId: worldId });
    const r = rows[0];
    return { worldId: r.world_id, note: r.note };
  }

  setWorldFavorited({ worldId, favorited = 1 }) {
    this.storage.run(
      `INSERT INTO world_cache (world_id, name, favorited)
       VALUES ($worldId, '', $favorited)
       ON CONFLICT(world_id) DO UPDATE SET favorited = $favorited, updated_at = datetime('now')`,
      { $worldId: worldId, $favorited: favorited ? 1 : 0 }
    );
    const rows = this.storage.query(`SELECT world_id, name, favorited FROM world_cache WHERE world_id = $worldId`, { $worldId: worldId });
    const row = rows[0];
    return { worldId: row.world_id, name: row.name || '', favorited: row.favorited === 1 };
  }

  rateWorld({ worldId, rating = 0 }) {
    const r = parseInt(rating, 10);
    const finalRating = r === -1 ? -1 : (r === 1 ? 1 : 0);
    this.storage.run(
      `INSERT INTO world_kb (world_id, world_name, tags, user_rating)
       VALUES ($worldId, '', '[]', $rating)
       ON CONFLICT(world_id) DO UPDATE SET user_rating = $rating`,
      { $worldId: worldId, $rating: finalRating }
    );
    const rows = this.storage.query(`SELECT world_id, world_name, user_rating FROM world_kb WHERE world_id = $worldId`, { $worldId: worldId });
    const row = rows[0];
    return { worldId: row.world_id, worldName: row.world_name || '', userRating: row.user_rating };
  }

  markWorldVisited({ worldId }) {
    const now = new Date().toISOString();
    this.storage.run(
      `INSERT INTO world_kb (world_id, world_name, tags, visited, visited_at)
       VALUES ($worldId, '', '[]', 1, $now)
       ON CONFLICT(world_id) DO UPDATE SET visited = 1, visited_at = $now, backlog = 0`,
      { $worldId: worldId, $now: now }
    );
    const rows = this.storage.query(`SELECT world_id, world_name, visited, visited_at, backlog FROM world_kb WHERE world_id = $worldId`, { $worldId: worldId });
    const row = rows[0];
    return { worldId: row.world_id, worldName: row.world_name || '', visited: row.visited === 1, visitedAt: row.visited_at, backlog: row.backlog === 1 };
  }

  setWorldSleep({ worldId, isSleep = true }) {
    const flag = isSleep ? 1 : 0;
    this.storage.run(
      `INSERT INTO world_kb (world_id, world_name, tags, sleep_ok)
       VALUES ($worldId, '', '[]', $flag)
       ON CONFLICT(world_id) DO UPDATE SET sleep_ok = $flag`,
      { $worldId: worldId, $flag: flag }
    );
    const rows = this.storage.query(`SELECT world_id, world_name, sleep_ok FROM world_kb WHERE world_id = $worldId`, { $worldId: worldId });
    const row = rows[0];
    return { worldId: row.world_id, worldName: row.world_name || '', isSleep: row.sleep_ok === 1 };
  }

  addToBacklog({ worldId, reason = '', priority = 0 }) {
    const now = new Date().toISOString();
    const p = Math.min(Math.max(parseInt(priority, 10) || 0, 0), 2);
    this.storage.run(
      `INSERT INTO world_kb (world_id, world_name, tags, backlog, backlog_added_at, backlog_reason, backlog_priority)
       VALUES ($worldId, '', '[]', 1, $now, $reason, $priority)
       ON CONFLICT(world_id) DO UPDATE SET
         backlog = 1,
         backlog_reason = CASE WHEN $reason != '' THEN $reason ELSE backlog_reason END,
         backlog_priority = $priority,
         backlog_added_at = COALESCE(backlog_added_at, $now)`,
      { $worldId: worldId, $now: now, $reason: reason, $priority: p }
    );
    const rows = this.storage.query(
      `SELECT world_id, world_name, backlog, backlog_added_at, backlog_reason, backlog_priority, visited, visited_at
       FROM world_kb WHERE world_id = $worldId`,
      { $worldId: worldId }
    );
    const row = rows[0];
    return {
      worldId: row.world_id, worldName: row.world_name || '',
      inBacklog: row.backlog === 1, addedAt: row.backlog_added_at,
      reason: row.backlog_reason || '', priority: row.backlog_priority,
      visited: row.visited === 1, visitedAt: row.visited_at,
    };
  }

  removeFromBacklog({ worldId }) {
    this.storage.run(`UPDATE world_kb SET backlog = 0 WHERE world_id = $worldId`, { $worldId: worldId });
    const rows = this.storage.query(`SELECT world_id, backlog FROM world_kb WHERE world_id = $worldId`, { $worldId: worldId });
    return { worldId, removed: rows.length === 0 || rows[0].backlog === 0 };
  }

  getWorldKbInfo(worldId) {
    const rows = this.storage.query(
      `SELECT world_id, world_name, author_name, author_id, created_at FROM world_kb WHERE world_id = $worldId`,
      { $worldId: worldId }
    );
    const row = rows[0];
    if (!row) return { worldId, worldName: '', authorName: '', authorId: '', createdAt: '' };
    return {
      worldId: row.world_id, worldName: row.world_name || '',
      authorName: row.author_name || '', authorId: row.author_id || '',
      createdAt: row.created_at || '',
    };
  }

  backfillWorldKbInfo({ worldId, name, authorName, authorId, createdAt }) {
    const sets = [];
    const params = { $worldId: worldId };
    if (name !== undefined && name !== '') { sets.push(`world_name = CASE WHEN COALESCE(world_name,'') = '' THEN $name ELSE world_name END`); params.$name = name; }
    if (authorName !== undefined && authorName !== '') { sets.push(`author_name = CASE WHEN COALESCE(author_name,'') = '' THEN $authorName ELSE author_name END`); params.$authorName = authorName; }
    if (authorId !== undefined && authorId !== '') { sets.push(`author_id = CASE WHEN COALESCE(author_id,'') = '' THEN $authorId ELSE author_id END`); params.$authorId = authorId; }
    if (createdAt !== undefined && createdAt !== '') { sets.push(`created_at = CASE WHEN COALESCE(created_at,'') = '' THEN $createdAt ELSE created_at END`); params.$createdAt = createdAt; }
    if (sets.length > 0) {
      this.storage.run(`UPDATE world_kb SET ${sets.join(', ')} WHERE world_id = $worldId`, params);
    }
    const rows = this.storage.query(
      `SELECT world_id, world_name, author_name, author_id, created_at FROM world_kb WHERE world_id = $worldId`,
      { $worldId: worldId }
    );
    const row = rows[0];
    return {
      worldId: row.world_id, worldName: row.world_name || '',
      authorName: row.author_name || '', authorId: row.author_id || '',
      createdAt: row.created_at || '',
    };
  }

  getBacklog({ status = 'pending', sortBy = 'added_at', limit = 20 } = {}) {
    const st = ['pending', 'visited', 'all'].includes(status) ? status : 'pending';
    const sortCol = ['added_at', 'priority', 'favorites'].includes(sortBy) ? sortBy : 'added_at';
    limit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
    let where = 'WHERE backlog = 1';
    if (st === 'pending') where += ' AND visited = 0';
    else if (st === 'visited') where += ' AND visited = 1';
    const order = sortCol === 'priority'
      ? 'backlog_priority DESC, backlog_added_at DESC'
      : `${sortCol === 'added_at' ? 'backlog_added_at' : sortCol} DESC`;
    const total = this.storage.query(`SELECT COUNT(*) AS cnt FROM world_kb ${where}`)[0].cnt;
    const rows = this.storage.query(
      `SELECT world_id, world_name, author_name, favorites, occupants, popularity, description, tags,
              created_at, visited, visited_at, backlog_added_at, backlog_reason, backlog_priority
       FROM world_kb ${where} ORDER BY ${order} LIMIT ${limit}`
    );
    const worlds = rows.map(r => {
      let worldTags = [];
      try { worldTags = JSON.parse(r.tags || '[]'); } catch { /* 脏数据按空数组 */ }
      return {
        worldId: r.world_id,
        worldName: r.world_name || '',
        authorName: r.author_name || '',
        favorites: r.favorites || 0,
        occupants: r.occupants || 0,
        popularity: r.popularity || 0,
        description: r.description || '',
        tags: Array.isArray(worldTags) ? worldTags : [],
        created: r.created_at || '',
        visited: r.visited === 1,
        visitedAt: r.visited_at || '',
        addedAt: r.backlog_added_at || '',
        reason: r.backlog_reason || '',
        priority: r.backlog_priority || 0,
      };
    });
    return { total, status: st, worlds };
  }

  getWorldHistory(worldId, limit = 50) {
    const rows = this.storage.query(
      `SELECT field, old_value, new_value, changed_at FROM world_history WHERE world_id = $worldId ORDER BY id DESC LIMIT $limit`,
      { $worldId: worldId, $limit: limit }
    );
    return rows.map(r => ({ field: r.field, oldValue: r.old_value, newValue: r.new_value, changedAt: r.changed_at }));
  }
}

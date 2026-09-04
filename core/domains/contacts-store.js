export class ContactsStore {
  constructor(storage) {
    this.storage = storage;
  }

  addToWatchlist(userId, displayName, priority = 0) {
    this.storage.run(
      `INSERT OR REPLACE INTO watchlist (user_id, display_name, priority)
       VALUES ($userId, $displayName, $priority)`,
      { $userId: userId, $displayName: displayName || '', $priority: priority }
    );
  }

  removeFromWatchlist(userId) {
    this.storage.run(`DELETE FROM watchlist WHERE user_id = $userId`, { $userId: userId });
  }

  getWatchlist() {
    return this.storage.query(`SELECT * FROM watchlist ORDER BY priority DESC, display_name`);
  }

  getNicknames({ userId, query } = {}) {
    if (userId) {
      const rows = this.storage.query(
        `SELECT user_id, display_name, nickname, updated_at FROM nicknames WHERE user_id = $userId`,
        { $userId: userId }
      );
      return rows.map(r => ({ userId: r.user_id, displayName: r.display_name, nickname: r.nickname, updatedAt: r.updated_at }));
    }

    if (query) {
      const q = `%${query}%`;
      const rows = this.storage.query(
        `SELECT user_id, display_name, nickname, updated_at FROM nicknames
         WHERE display_name LIKE $q OR nickname LIKE $q
         ORDER BY display_name`,
        { $q: q }
      );
      return rows.map(r => ({ userId: r.user_id, displayName: r.display_name, nickname: r.nickname, updatedAt: r.updated_at }));
    }

    const rows = this.storage.query(`SELECT user_id, display_name, nickname, updated_at FROM nicknames ORDER BY display_name`);
    return rows.map(r => ({ userId: r.user_id, displayName: r.display_name, nickname: r.nickname, updatedAt: r.updated_at }));
  }

  setNickname({ userId, nickname, displayName = '' } = {}) {
    this.storage.run(
      `INSERT INTO nicknames (user_id, display_name, nickname, updated_at)
       VALUES ($userId, $displayName, $nickname, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         display_name = CASE WHEN excluded.display_name = '' THEN nicknames.display_name ELSE excluded.display_name END,
         nickname = excluded.nickname,
         updated_at = datetime('now')`,
      { $userId: userId, $displayName: displayName || '', $nickname: nickname }
    );
    const rows = this.storage.query(
      `SELECT user_id, display_name, nickname, updated_at FROM nicknames WHERE user_id = $userId`,
      { $userId: userId }
    );
    const r = rows[0];
    return { userId: r.user_id, displayName: r.display_name, nickname: r.nickname, updatedAt: r.updated_at };
  }
}

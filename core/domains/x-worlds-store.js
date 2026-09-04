export class XWorldsStore {
  constructor(storage) {
    this.storage = storage;
  }

  getXWorld(worldId) {
    const rows = this.storage.query(
      `SELECT * FROM x_world_recommendations WHERE world_id = $worldId`,
      { $worldId: worldId }
    );
    return rows.length > 0 ? rows[0] : null;
  }

  insertXWorld({ worldId, worldName, authorName, description, imageUrl, favorites, visits, popularity, capacity, tags, firstSeenAt, lastRecommendedAt, creators, tweetCount }) {
    this.storage.run(
      `INSERT INTO x_world_recommendations
        (world_id, world_name, author_name, description, image_url, favorites, visits, popularity, capacity, tags,
         first_seen_at, last_recommended_at, creators, tweet_count)
       VALUES ($worldId, $worldName, $authorName, $description, $imageUrl, $favorites, $visits, $popularity, $capacity, $tags,
         $firstSeenAt, $lastRecommendedAt, $creators, $tweetCount)
       ON CONFLICT(world_id) DO UPDATE SET
         world_name = $worldName, author_name = $authorName, description = $description, image_url = $imageUrl,
         favorites = $favorites, visits = $visits, popularity = $popularity, capacity = $capacity, tags = $tags,
         last_recommended_at = $lastRecommendedAt, tweet_count = $tweetCount`,
      {
        $worldId: worldId, $worldName: worldName || '', $authorName: authorName || '',
        $description: description || '', $imageUrl: imageUrl || '',
        $favorites: favorites || 0, $visits: visits || 0, $popularity: popularity || 0,
        $capacity: capacity || 0, $tags: tags || '[]',
        $firstSeenAt: firstSeenAt || new Date().toISOString(),
        $lastRecommendedAt: lastRecommendedAt || new Date().toISOString(),
        $creators: creators || '[]', $tweetCount: tweetCount || 1,
      }
    );
  }

  updateXWorld(worldId, { worldName, authorName, description, imageUrl, favorites, visits, popularity, capacity, tags, lastRecommendedAt, creators, tweetCount }) {
    this.storage.run(
      `UPDATE x_world_recommendations SET
         world_name = $worldName, author_name = $authorName, description = $description, image_url = $imageUrl,
         favorites = $favorites, visits = $visits, popularity = $popularity, capacity = $capacity, tags = $tags,
         last_recommended_at = $lastRecommendedAt, creators = $creators, tweet_count = $tweetCount
       WHERE world_id = $worldId`,
      {
        $worldId: worldId, $worldName: worldName || '', $authorName: authorName || '',
        $description: description || '', $imageUrl: imageUrl || '',
        $favorites: favorites || 0, $visits: visits || 0, $popularity: popularity || 0,
        $capacity: capacity || 0, $tags: tags || '[]',
        $lastRecommendedAt: lastRecommendedAt || new Date().toISOString(),
        $creators: creators || '[]', $tweetCount: tweetCount || 1,
      }
    );
  }

  getXWorldsSince(sinceIso, { creator, limit = 100 } = {}) {
    let sql = `SELECT * FROM x_world_recommendations WHERE last_recommended_at >= $since`;
    const params = { $since: sinceIso };
    if (creator) {
      sql += ` AND creators LIKE $creator`;
      params.$creator = `%${creator}%`;
    }
    sql += ` ORDER BY last_recommended_at DESC LIMIT $limit`;
    params.$limit = limit;
    return this.storage.query(sql, params);
  }

  getAllXWorlds(limit = 200) {
    return this.storage.query(`SELECT * FROM x_world_recommendations ORDER BY favorites DESC LIMIT $limit`, { $limit: limit });
  }

  clearXWorlds() {
    this.storage.run(`DELETE FROM x_world_recommendations`);
  }
}

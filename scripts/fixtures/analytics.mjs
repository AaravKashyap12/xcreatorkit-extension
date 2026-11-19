// Deterministic synthetic analytics; never reads a creator's private captures.
export const capture = {
  account: 'fixturecreator', capturedAt: '2026-10-02T18:08:00.000Z',
  range: { from: '2026-03-17', to: '2026-10-02' },
  points: Array.from({ length: 200 }, (_, i) => ({
    t: Date.UTC(2026, 9, 2) - (199 - i) * 864e5,
    m: { Impressions: 2000 + ((i * 937) % 5000), Engagements: 50 + (i % 40),
      Likes: 30, Replies: 10, Retweets: 2, Bookmark: 1, Share: 0,
      ProfileVisits: 12, Follows: 5, Unfollows: 1, CreateTweet: 3, CreateReply: 40 },
  })),
};

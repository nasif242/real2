const favoritesCmd = require('./favorites');

module.exports = {
  name: 'wishlist',
  description: 'View your favorites and wishlist',
  options: [],
  execute(ctx) {
    return favoritesCmd.execute(ctx);
  }
};

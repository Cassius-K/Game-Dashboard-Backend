const mongoose = require('mongoose');

const GameSchema = new mongoose.Schema({
    userId: { type: String, required: true }, // The SteamID or PSN AccountID
    platform: { type: String, required: true }, // 'Steam' or 'PSN'
    platformGameId: { type: String, required: true }, // The appid (Steam) or npId (PSN)
    name: String,
    img_icon_url: String,
    playtime_forever: { type: Number, default: 0 },
	completionRate: { type: Number, default: 0 } 
});

module.exports = mongoose.model('Game', GameSchema);
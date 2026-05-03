const mongoose = require('mongoose');
const GameSchema = new mongoose.Schema({
    userId: String, // Link to SteamId or PsnId
    platform: { type: String, required: true }, // 'Steam' or 'PSN'
    platformGameId: { type: String, required: true }, // appid for Steam, npCommunicationId for PSN
    name: String,
    img_icon_url: String,
    playtime_forever: { type: Number, default: 0 }
});
module.exports = mongoose.model('Game', GameSchema);
const mongoose = require('mongoose');
const GameSchema = new mongoose.Schema({
    appid: { type: Number, unique: true },
    name: String,
    img_icon_url: String,
    playtime_forever: Number // Store how long they've played
});
module.exports = mongoose.model('Game', GameSchema);
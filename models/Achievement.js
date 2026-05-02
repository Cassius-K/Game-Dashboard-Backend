const mongoose = require('mongoose');
const AchievementSchema = new mongoose.Schema({
    userId: String, // Link to SteamID
    appid: Number,  // Link to Game
    apiname: String,
    achieved: Number, // 1 for yes, 0 for no
    unlocktime: Number
});
module.exports = mongoose.model('Achievement', AchievementSchema);
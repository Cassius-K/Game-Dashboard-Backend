const mongoose = require('mongoose');
const AchievementSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    platform: String,
    platformGameId: String,
    apiname: String, // unique ID for the trophy
    displayName: String,
    description: String,
    iconUrl: String,
    achieved: Number,
    unlocktime: Number
});
module.exports = mongoose.model('Achievement', AchievementSchema);